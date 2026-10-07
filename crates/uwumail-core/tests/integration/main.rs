//! All integration tests of uwumail-core in one test binary: one link instead of one per file,
//! and every test runs in parallel with the others. Pick a part by its module, e.g.
//!
//!   cargo test -p uwumail-core --test integration greenmail::
//!
//! The tests against real servers skip themselves unless their server is configured (see each
//! module: GreenMail, Stalwart, a UwUMail server, the internet for pictures_live).

mod support;

mod caldav_hostile;
mod carddav_hostile;
mod greenmail;
mod image_text;
mod jmap_account;
mod jmap_hostile;
mod jmap_push;
mod jmap_scheduled;
mod pictures_live;
mod stalwart;
mod uwumail_login;
mod uwumail_server;
mod uwumail_server_caldav;
mod uwumail_server_calendar;
mod uwumail_server_contacts;
mod uwumail_server_imap;
