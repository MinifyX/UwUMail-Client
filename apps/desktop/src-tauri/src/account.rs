//! What a mailbox's UwUMail server keeps for the person (masked addresses, the own profile
//! picture, sharing calendars), and contact photos at Microsoft and Google. The engine does the
//! work with the login it holds; these commands only hand it on.

use tauri::State;
use uwumail_core::engine::ServerAccountFeatures;
use uwumail_core::jmap_masked::{MaskedAddress, MaskedInput, MaskedPatch};
use uwumail_core::jmap_profile::{ProfilePatch, ProfilePicture};
use uwumail_core::model::Person;
use uwumail_core::{Engine, Error};

type CommandResult<T> = Result<T, Error>;

/// Per mailbox on a UwUMail server: masked addresses and profile picture, where it has them.
#[tauri::command]
pub async fn server_account_features(engine: State<'_, Engine>) -> CommandResult<Vec<ServerAccountFeatures>> {
    engine.server_account_features().await
}

#[tauri::command]
pub async fn masked_addresses(engine: State<'_, Engine>, account_id: String) -> CommandResult<Vec<MaskedAddress>> {
    engine.masked_addresses(&account_id).await
}

#[tauri::command]
pub async fn create_masked_address(
    engine: State<'_, Engine>,
    account_id: String,
    input: MaskedInput,
) -> CommandResult<MaskedAddress> {
    engine.create_masked_address(&account_id, &input).await
}

#[tauri::command]
pub async fn update_masked_address(
    engine: State<'_, Engine>,
    account_id: String,
    id: String,
    patch: MaskedPatch,
) -> CommandResult<()> {
    engine.update_masked_address(&account_id, &id, &patch).await
}

#[tauri::command]
pub async fn profile_picture(engine: State<'_, Engine>, account_id: String) -> CommandResult<ProfilePicture> {
    engine.profile_picture(&account_id).await
}

/// A new picture as a `data:` URI the page cropped, or `None` to remove it.
#[tauri::command]
pub async fn set_profile_picture(
    engine: State<'_, Engine>,
    account_id: String,
    picture: Option<String>,
) -> CommandResult<ProfilePicture> {
    engine.set_profile_picture(&account_id, picture.as_deref()).await
}

#[tauri::command]
pub async fn update_profile_picture(
    engine: State<'_, Engine>,
    account_id: String,
    patch: ProfilePatch,
) -> CommandResult<()> {
    engine.update_profile_picture(&account_id, &patch).await
}

#[tauri::command]
pub async fn calendar_people(engine: State<'_, Engine>, account_id: String) -> CommandResult<Vec<Person>> {
    engine.calendar_people(&account_id).await
}

/// `level` is `read`, `write` or `all`; `None` stops sharing with the person.
#[tauri::command]
pub async fn share_calendar(
    engine: State<'_, Engine>,
    calendar_id: String,
    person_id: String,
    level: Option<String>,
) -> CommandResult<()> {
    engine.share_calendar(&calendar_id, &person_id, level.as_deref()).await
}

/// The photo Microsoft or Google keeps for a contact, as a `data:` URI.
#[tauri::command]
pub async fn contact_photo(engine: State<'_, Engine>, card_id: String) -> CommandResult<Option<String>> {
    engine.contact_photo(&card_id).await
}
