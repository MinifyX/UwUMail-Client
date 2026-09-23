//! Folders people make themselves: create, rename, delete, and emptying the trash and junk.

use super::*;

impl Engine {
    /// Creates a folder below `parent_id`, or at the top of a mailbox. Returns its id.
    pub async fn create_folder(&self, account_id: Option<&str>, name: &str, parent_id: Option<&str>) -> Result<String> {
        let store = &self.inner.store;
        let parent = match parent_id {
            Some(id) => Some(store.folder(id).map_err(|_| Error::not_found("The parent folder no longer exists."))?),
            None => None,
        };
        let account_id = match (&parent, account_id) {
            (Some(parent), Some(given)) if parent.account_id != given => {
                return Err(Error::invalid("The parent folder belongs to another mailbox."));
            }
            (Some(parent), _) => parent.account_id.clone(),
            (None, Some(given)) => given.to_string(),
            (None, None) => match store.accounts()?.as_slice() {
                [only] => only.id.clone(),
                _ => return Err(Error::invalid("Pick the mailbox for the new folder.")),
            },
        };
        let account = store.account(&account_id)?;
        let siblings: Vec<Folder> = store
            .folders(Some(&account_id))?
            .into_iter()
            .filter(|folder| folder.parent_id.as_deref() == parent_id)
            .collect();

        let id = if account.protocol == Protocol::Jmap {
            let name = folders::clean_name(name, Some("/"), false)?;
            refuse_duplicate(&siblings, &name, None)?;
            let client = self.inner.jmap_client(&account_id).await?;
            let parent_ref = parent.as_ref().map(|p| p.path.as_str());
            let mailbox = jmap_sync::create_mailbox(&client, &name, parent_ref).await?;
            self.inner.remember_created(&account_id, &mailbox);
            store.upsert_folder(
                &account_id,
                &FolderInfo { path: &mailbox, name: &name, role: None, delimiter: None, selectable: true, parent_ref },
            )?
        } else {
            let records = store.folder_records(&account_id)?;
            let delimiter = parent
                .as_ref()
                .and_then(|p| p.delimiter.clone())
                .or_else(|| records.iter().find_map(|f| f.delimiter.clone()))
                .filter(|d| !d.is_empty());
            let name = folders::clean_name(name, delimiter.as_deref(), true)?;
            refuse_duplicate(&siblings, &name, None)?;
            let namespace = folders::inbox_namespace(records.iter().map(|f| (f.path.as_str(), f.delimiter.as_deref())));
            let path = folders::child_path(
                parent.as_ref().map(|p| p.path.as_str()),
                &name,
                delimiter.as_deref(),
                namespace.as_deref(),
            )?;
            with_session!(self.inner, &account_id, |session| imap::create_folder(session, &path))?;
            self.inner.remember_created(&account_id, &path);
            store.upsert_folder(
                &account_id,
                &FolderInfo {
                    path: &path,
                    name: &name,
                    role: None,
                    delimiter: delimiter.as_deref(),
                    selectable: true,
                    parent_ref: None,
                },
            )?
        };
        self.inner.emit(EngineEvent::MailChanged { account_id: account_id.clone() });
        self.inner.wake(&account_id);
        Ok(id)
    }

    /// Renames a folder; folders inside it keep their place below it.
    pub async fn rename_folder(&self, folder_id: &str, name: &str) -> Result<()> {
        let store = &self.inner.store;
        let folder = store.folder(folder_id).map_err(|_| Error::not_found("This folder no longer exists."))?;
        if folder.role.is_some() || folder.path.eq_ignore_ascii_case("INBOX") {
            return Err(Error::invalid("System folders like the inbox or the trash keep their names."));
        }
        let account = store.account(&folder.account_id)?;
        let listed = store.folders(Some(&folder.account_id))?;
        let parent_id = listed.iter().find(|f| f.id == folder.id).and_then(|f| f.parent_id.clone());
        let siblings: Vec<Folder> = listed.into_iter().filter(|f| f.parent_id == parent_id).collect();

        if account.protocol == Protocol::Jmap {
            let name = folders::clean_name(name, Some("/"), false)?;
            refuse_duplicate(&siblings, &name, Some(folder_id))?;
            let client = self.inner.jmap_client(&folder.account_id).await?;
            jmap_sync::rename_mailbox(&client, &folder.path, &name).await?;
            store.set_folder_name(folder_id, &name)?;
        } else {
            let delimiter = folder.delimiter.clone().filter(|d| !d.is_empty());
            let name = folders::clean_name(name, delimiter.as_deref(), true)?;
            refuse_duplicate(&siblings, &name, Some(folder_id))?;
            let path = folders::renamed_path(&folder.path, &name, delimiter.as_deref());
            if path != folder.path {
                with_session!(self.inner, &folder.account_id, |session| imap::rename_folder(
                    session,
                    &folder.path,
                    &path
                ))?;
                self.inner.remember_created(&folder.account_id, &path);
            }
            store.rename_folder(folder_id, &path, &name)?;
        }
        self.inner.emit(EngineEvent::MailChanged { account_id: folder.account_id.clone() });
        self.inner.wake(&folder.account_id);
        Ok(())
    }

    /// Deletes a folder after moving its mail into the trash. Folders with folders inside stay.
    pub async fn delete_folder(&self, folder_id: &str) -> Result<()> {
        let store = &self.inner.store;
        let folder = store.folder(folder_id).map_err(|_| Error::not_found("This folder no longer exists."))?;
        if folder.role.is_some() || folder.path.eq_ignore_ascii_case("INBOX") {
            return Err(Error::invalid("System folders like the inbox or the trash can't be deleted."));
        }
        let has_children = || Error::invalid("This folder still has folders inside. Move or delete those first.");
        if store.folders(Some(&folder.account_id))?.iter().any(|f| f.parent_id.as_deref() == Some(folder_id)) {
            return Err(has_children());
        }
        let account_id = folder.account_id.clone();
        if store.account(&account_id)?.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(&account_id).await?;
            let trash = jmap_sync::ensure_mailbox(&client, store, &account_id, FolderRole::Trash).await?;
            self.inner.remember_created(&account_id, &trash.path);
            jmap_sync::destroy_mailbox(&client, &folder.path, &trash.path).await?;
        } else {
            let delimiter = folder.delimiter.clone().unwrap_or_default();
            if with_session!(self.inner, &account_id, |session| imap::has_children(session, &folder.path, &delimiter))?
            {
                return Err(has_children());
            }
            if folder.selectable {
                let trash = self.inner.ensure_folder(&account_id, FolderRole::Trash).await?;
                with_session!(self.inner, &account_id, |session| imap::move_all(session, &folder.path, &trash.path))?;
            }
            with_session!(self.inner, &account_id, |session| imap::delete_folder(session, &folder.path))?;
        }
        store.delete_folder(folder_id)?;
        self.inner.emit(EngineEvent::MailChanged { account_id: account_id.clone() });
        self.inner.wake(&account_id);
        Ok(())
    }

    /// Deletes everything in the trash or the junk folder for good. Returns how many messages went.
    pub async fn empty_folder(&self, folder_id: &str) -> Result<usize> {
        let store = &self.inner.store;
        let folder = store.folder(folder_id).map_err(|_| Error::not_found("This folder no longer exists."))?;
        if !matches!(folder.role, Some(FolderRole::Trash | FolderRole::Junk)) {
            return Err(Error::invalid("Only the trash and the junk folder can be emptied."));
        }
        let account_id = folder.account_id.clone();
        let removed = if store.account(&account_id)?.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(&account_id).await?;
            jmap_sync::empty_mailbox(&client, &folder.path).await?
        } else {
            let count = with_session!(self.inner, &account_id, |session| imap::expunge_all(session, &folder.path))?;
            usize::try_from(count).unwrap_or(usize::MAX)
        };
        store.clear_folder(folder_id)?;
        self.inner.emit(EngineEvent::MailChanged { account_id: account_id.clone() });
        self.inner.wake(&account_id);
        Ok(removed)
    }
}

/// Two folders with the same name side by side can't be told apart.
fn refuse_duplicate(siblings: &[Folder], name: &str, except: Option<&str>) -> Result<()> {
    let taken = siblings
        .iter()
        .any(|folder| Some(folder.id.as_str()) != except && folder.name.to_lowercase() == name.to_lowercase());
    if taken {
        return Err(Error::invalid(format!("There's already a folder called \"{name}\" here.")));
    }
    Ok(())
}

impl Inner {
    /// Keeps a folder UwUMail just made through a sync whose listing started before.
    fn remember_created(&self, account_id: &str, path: &str) {
        self.created_folders.lock().unwrap().insert((account_id.to_string(), path.to_string()), Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(id: &str, name: &str) -> Folder {
        Folder {
            id: id.into(),
            account_id: "a".into(),
            name: name.into(),
            path: name.into(),
            role: None,
            parent_id: None,
            selectable: true,
            unread: 0,
            total: 0,
        }
    }

    #[test]
    fn refuses_a_second_folder_of_the_same_name() {
        let siblings = [named("1", "Rechnungen"), named("2", "Kunden")];
        assert!(refuse_duplicate(&siblings, "rechnungen", None).is_err());
        assert!(refuse_duplicate(&siblings, "Rechnungen", Some("1")).is_ok(), "renaming to its own name");
        assert!(refuse_duplicate(&siblings, "Projekte", None).is_ok());
    }

    #[tokio::test]
    async fn only_trash_and_junk_can_be_emptied_and_system_folders_stay() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: Arc::new(crate::secrets::MemorySecrets::default()),
            open_url: Arc::new(|_| {}),
        })
        .unwrap();
        let store = &engine.inner.store;
        store
            .insert_account(&AccountRecord {
                id: "a".into(),
                name: "Test".into(),
                email: "mini@uwumail.test".into(),
                display_name: "Mini".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "mini@uwumail.test".into(),
                imap: ServerSettings { host: "imap.uwumail.test".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.uwumail.test".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        let folder = |path: &str, role| {
            store
                .upsert_folder(
                    "a",
                    &FolderInfo { path, name: path, role, delimiter: Some("/"), selectable: true, parent_ref: None },
                )
                .unwrap()
        };
        let inbox = folder("INBOX", Some(FolderRole::Inbox));
        let sent = folder("Sent", Some(FolderRole::Sent));
        let parent = folder("Kunden", None);
        folder("Kunden/Bright", None);

        // All of these fail before anything talks to a server.
        assert_eq!(engine.empty_folder(&inbox).await.unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(engine.empty_folder(&parent).await.unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(engine.rename_folder(&sent, "Raus").await.unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(engine.delete_folder(&inbox).await.unwrap_err().code, ErrorCode::InvalidInput);
        let with_children = engine.delete_folder(&parent).await.unwrap_err();
        assert!(with_children.message.contains("folders inside"), "{}", with_children.message);
        assert_eq!(engine.rename_folder(&parent, "a/b").await.unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(
            engine.create_folder(Some("a"), "kunden", None).await.unwrap_err().code,
            ErrorCode::InvalidInput,
            "a folder of that name is there already"
        );
        assert_eq!(engine.create_folder(None, " ", Some(&parent)).await.unwrap_err().code, ErrorCode::InvalidInput);
    }
}
