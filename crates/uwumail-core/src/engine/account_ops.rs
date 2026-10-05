//! What a UwUMail server keeps for the person behind a mailbox: masked addresses, the own profile
//! picture, and sharing calendars with the people of the server. Only mailboxes that sign in over
//! JMAP to a server offering these have them; everything goes through the login the engine
//! holds, so no password or token ever reaches the page.

use serde::Serialize;

use super::*;
use crate::calendar::{Source as CalendarSource, jmap_cal};
use crate::jmap_masked::{self, MaskedAddress, MaskedInput, MaskedOptions, MaskedPatch};
use crate::jmap_profile::{self, ProfileOptions, ProfilePatch, ProfilePicture};

/// How long the settings wait for one server to tell what it offers.
const FEATURES_WAIT: Duration = Duration::from_secs(4);

/// What a mailbox's UwUMail server keeps for the person; mailboxes without any are left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAccountFeatures {
    pub account_id: String,
    pub masked: Option<MaskedOptions>,
    pub profile: Option<ProfileOptions>,
}

impl Engine {
    /// The JMAP login of a mailbox, for what only its own server keeps.
    async fn server_client(&self, account_id: &str) -> Result<Arc<JmapClient>> {
        if self.inner.store.account(account_id)?.protocol != Protocol::Jmap {
            return Err(Error::not_supported("This needs a mailbox on a UwUMail server."));
        }
        self.inner.jmap_client(account_id).await
    }

    /// Per mailbox on a UwUMail server, whether it makes masked addresses and keeps a profile
    /// picture. Servers that can't be reached right now, or take too long, are left out.
    pub async fn server_account_features(&self) -> Result<Vec<ServerAccountFeatures>> {
        let accounts: Vec<_> =
            self.inner.store.accounts()?.into_iter().filter(|account| account.protocol == Protocol::Jmap).collect();
        let asks = accounts.into_iter().map(|account| async move {
            let ask = self.inner.jmap_client(&account.id);
            match tokio::time::timeout(FEATURES_WAIT, ask).await {
                Ok(Ok(client)) => {
                    let features = ServerAccountFeatures {
                        account_id: account.id.clone(),
                        masked: jmap_masked::options(&client),
                        profile: jmap_profile::options(&client),
                    };
                    (features.masked.is_some() || features.profile.is_some()).then_some(features)
                }
                Ok(Err(error)) => {
                    tracing::debug!("{} couldn't tell what its server offers: {error}", account.id);
                    None
                }
                Err(_) => None,
            }
        });
        Ok(futures::future::join_all(asks).await.into_iter().flatten().collect())
    }

    pub async fn masked_addresses(&self, account_id: &str) -> Result<Vec<MaskedAddress>> {
        jmap_masked::list(&*self.server_client(account_id).await?).await
    }

    pub async fn create_masked_address(&self, account_id: &str, input: &MaskedInput) -> Result<MaskedAddress> {
        jmap_masked::create(&*self.server_client(account_id).await?, input).await
    }

    pub async fn update_masked_address(&self, account_id: &str, id: &str, patch: &MaskedPatch) -> Result<()> {
        jmap_masked::update(&*self.server_client(account_id).await?, id, patch).await
    }

    pub async fn profile_picture(&self, account_id: &str) -> Result<ProfilePicture> {
        jmap_profile::get(&*self.server_client(account_id).await?).await
    }

    /// Stores a new picture (a `data:` URI the page cropped) or removes it with `None`.
    pub async fn set_profile_picture(&self, account_id: &str, picture: Option<&str>) -> Result<ProfilePicture> {
        jmap_profile::set_picture(&*self.server_client(account_id).await?, picture).await
    }

    pub async fn update_profile_picture(&self, account_id: &str, patch: &ProfilePatch) -> Result<()> {
        jmap_profile::update(&*self.server_client(account_id).await?, patch).await
    }

    /// The people of a mailbox's server to share its calendars with.
    pub async fn calendar_people(&self, account_id: &str) -> Result<Vec<Person>> {
        jmap_cal::people(&*self.server_client(account_id).await?).await
    }

    /// Shares a calendar with a person of its server at a level (`read`, `write`, `all`), or stops
    /// sharing it with them (`None`).
    pub async fn share_calendar(&self, calendar_id: &str, person_id: &str, level: Option<&str>) -> Result<()> {
        let (source, entry) = self.inner.calendar_entry(calendar_id).await?;
        if !matches!(source, CalendarSource::Jmap) || !entry.info.sharing.may_share {
            return Err(Error::invalid("This calendar can't be shared from here."));
        }
        let client = self.server_client(&entry.info.account_id).await?;
        jmap_cal::share_calendar(&client, &entry.remote, person_id, level).await?;
        self.inner.calendar_changed(Some(&entry.info.account_id));
        Ok(())
    }
}
