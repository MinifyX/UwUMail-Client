//! A small, careful XML reader for WebDAV answers.
//!
//! The answer comes from a server we don't control, so the tree has limits (depth, number of
//! elements, amount of text), namespaces are resolved, and only the five predefined entities
//! and character references are understood. A DOCTYPE is refused outright: no entity of the
//! server's own is ever expanded.

use quick_xml::NsReader;
use quick_xml::events::Event;
use quick_xml::name::ResolveResult;

use crate::error::{Error, Result};

pub const DAV: &str = "DAV:";
pub const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
pub const CARDDAV: &str = "urn:ietf:params:xml:ns:carddav";
pub const APPLE: &str = "http://apple.com/ns/ical/";
pub const CALSERVER: &str = "http://calendarserver.org/ns/";

const MAX_DEPTH: usize = 48;
const MAX_ELEMENTS: usize = 200_000;
const MAX_TEXT: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Element {
    pub namespace: String,
    pub name: String,
    pub attributes: Vec<(String, String)>,
    pub children: Vec<Element>,
    pub text: String,
}

impl Element {
    pub fn is(&self, namespace: &str, name: &str) -> bool {
        self.namespace == namespace && self.name == name
    }

    pub fn child(&self, namespace: &str, name: &str) -> Option<&Element> {
        self.children.iter().find(|child| child.is(namespace, name))
    }

    pub fn children_named<'a>(&'a self, namespace: &'a str, name: &'a str) -> impl Iterator<Item = &'a Element> {
        self.children.iter().filter(move |child| child.is(namespace, name))
    }

    /// The first element of that name anywhere below, depth first.
    pub fn find(&self, namespace: &str, name: &str) -> Option<&Element> {
        self.children
            .iter()
            .find_map(|child| if child.is(namespace, name) { Some(child) } else { child.find(namespace, name) })
    }

    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    pub fn trimmed_text(&self) -> &str {
        self.text.trim()
    }
}

fn malformed(detail: impl std::fmt::Display) -> Error {
    Error::connection(format!("The calendar server sent something that isn't valid XML ({detail})."))
}

/// Parses a whole document into its root element.
pub fn parse(bytes: &[u8]) -> Result<Element> {
    let text = std::str::from_utf8(bytes).map_err(|_| malformed("not UTF-8"))?;
    let mut reader = NsReader::from_str(text);
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    let mut elements = 0usize;
    let mut text_size = 0usize;

    let open = |start: &quick_xml::events::BytesStart<'_>, namespace: ResolveResult<'_>| {
        let namespace = match namespace {
            ResolveResult::Bound(ns) => ns.0.to_string(),
            _ => String::new(),
        };
        let name = start.local_name().as_ref().to_string();
        let mut attributes = Vec::new();
        for attribute in start.attributes().flatten() {
            let key = attribute.key.local_name().as_ref().to_string();
            let value = attribute.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(malformed)?;
            attributes.push((key, value.into_owned()));
        }
        Ok::<_, Error>(Element { namespace, name, attributes, children: Vec::new(), text: String::new() })
    };

    loop {
        let (namespace, event) = reader.read_resolved_event().map_err(malformed)?;
        match event {
            Event::Start(start) => {
                elements += 1;
                if elements > MAX_ELEMENTS || stack.len() >= MAX_DEPTH {
                    return Err(malformed("too deeply nested or too big"));
                }
                let element = open(&start, namespace)?;
                stack.push(element);
            }
            Event::Empty(start) => {
                elements += 1;
                if elements > MAX_ELEMENTS || stack.len() >= MAX_DEPTH {
                    return Err(malformed("too deeply nested or too big"));
                }
                let element = open(&start, namespace)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(element),
                    None if root.is_none() => root = Some(element),
                    None => return Err(malformed("more than one root")),
                }
            }
            Event::End(_) => {
                let element = stack.pop().ok_or_else(|| malformed("an end without a start"))?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(element),
                    None if root.is_none() => root = Some(element),
                    None => return Err(malformed("more than one root")),
                }
            }
            Event::Text(content) => {
                let content = content.xml10_content();
                push_text(&mut stack, &content, &mut text_size)?;
            }
            Event::CData(content) => {
                let content = content.into_inner().into_owned();
                push_text(&mut stack, &content, &mut text_size)?;
            }
            Event::GeneralRef(reference) => {
                let resolved = if reference.is_char_ref() {
                    reference.resolve_char_ref().map_err(malformed)?.map(String::from)
                } else {
                    match &*reference {
                        "lt" => Some("<".into()),
                        "gt" => Some(">".into()),
                        "amp" => Some("&".into()),
                        "apos" => Some("'".into()),
                        "quot" => Some("\"".into()),
                        _ => None,
                    }
                };
                let resolved = resolved.ok_or_else(|| malformed("an unknown entity"))?;
                push_text(&mut stack, &resolved, &mut text_size)?;
            }
            Event::DocType(_) => return Err(malformed("a DOCTYPE")),
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) => {}
            Event::Eof => break,
        }
    }
    if !stack.is_empty() {
        return Err(malformed("it ends in the middle"));
    }
    root.ok_or_else(|| malformed("it's empty"))
}

fn push_text(stack: &mut [Element], content: &str, size: &mut usize) -> Result<()> {
    *size += content.len();
    if *size > MAX_TEXT {
        return Err(malformed("too much text"));
    }
    if let Some(element) = stack.last_mut() {
        element.text.push_str(content);
    }
    Ok(())
}

/// Text for an XML element's content.
pub fn escape(text: &str) -> String {
    quick_xml::escape::escape(text).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_namespaces_and_entities() {
        let root = parse(
            br#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
            <d:response><d:href>/cal/a%20b/</d:href><d:propstat><d:prop>
              <d:displayname>Work &amp; Play &#x1F3B2;</d:displayname>
              <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
              <x:color xmlns:x="http://apple.com/ns/ical/"><![CDATA[#FF0000FF]]></x:color>
            </d:prop></d:propstat></d:response></d:multistatus>"#,
        )
        .unwrap();
        assert!(root.is(DAV, "multistatus"));
        let prop = root.find(DAV, "prop").unwrap();
        assert_eq!(prop.child(DAV, "displayname").unwrap().trimmed_text(), "Work & Play 🎲");
        assert_eq!(prop.find(CALDAV, "comp").unwrap().attribute("name"), Some("VEVENT"));
        assert_eq!(prop.child(APPLE, "color").unwrap().trimmed_text(), "#FF0000FF");
        // The default namespace counts too.
        let plain = parse(b"<multistatus xmlns=\"DAV:\"><response/></multistatus>").unwrap();
        assert!(plain.child(DAV, "response").is_some());
    }

    #[test]
    fn refuses_hostile_documents() {
        // Entity expansion ("billion laughs") never happens: DOCTYPEs are refused.
        let laughs = br#"<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
            <d:multistatus xmlns:d="DAV:">&lol2;</d:multistatus>"#;
        assert!(parse(laughs).is_err());
        // External entities neither.
        let external = br#"<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><x>&xxe;</x>"#;
        assert!(parse(external).is_err());
        // Unknown entities without a DOCTYPE.
        assert!(parse(b"<x>&nbsp;</x>").is_err());
        // Endless nesting.
        let deep = format!("{}{}", "<a>".repeat(1000), "</a>".repeat(1000));
        assert!(parse(deep.as_bytes()).is_err());
        // Broken documents.
        assert!(parse(b"<a><b></a>").is_err());
        assert!(parse(b"<a>").is_err());
        assert!(parse(b"").is_err());
        assert!(parse(b"<a/><b/>").is_err());
        assert!(parse(&[0xff, 0xfe, 0x00]).is_err());
    }
}
