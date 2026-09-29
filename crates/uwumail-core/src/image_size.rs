//! A picture's size from its first bytes, so the reader can hold its place before it shows: PNG,
//! GIF, JPEG and WebP from their headers, SVG from the `width`/`height` or `viewBox` of its root.
//! Nothing is decoded; an unknown or broken picture has no size.

/// Width and height in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelSize {
    pub width: u32,
    pub height: u32,
}

/// How far into an SVG its `<svg …>` tag is looked for.
const SVG_HEAD: usize = 16 * 1024;
/// How many JPEG segments are skipped at most before its frame header.
const JPEG_SEGMENTS: usize = 64;

/// The size a picture declares in its header; `None` when there is none or it is broken.
pub fn image_size(bytes: &[u8]) -> Option<PixelSize> {
    let size = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png(bytes)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        gif(bytes)
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        jpeg(bytes)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        webp(bytes)
    } else {
        svg(bytes)
    }?;
    (size.width > 0 && size.height > 0).then_some(size)
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?)))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?)))
}

fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 3)?;
    Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
}

/// The IHDR chunk comes first.
fn png(bytes: &[u8]) -> Option<PixelSize> {
    (bytes.get(12..16)? == b"IHDR").then_some(())?;
    Some(PixelSize { width: be32(bytes, 16)?, height: be32(bytes, 20)? })
}

/// The logical screen of a GIF.
fn gif(bytes: &[u8]) -> Option<PixelSize> {
    Some(PixelSize { width: le16(bytes, 6)?, height: le16(bytes, 8)? })
}

/// The first start-of-frame segment; every other one is skipped by its length.
fn jpeg(bytes: &[u8]) -> Option<PixelSize> {
    let mut at = 2;
    for _ in 0..JPEG_SEGMENTS {
        // Markers may be padded with any number of 0xFF.
        (*bytes.get(at)? == 0xFF).then_some(())?;
        while *bytes.get(at)? == 0xFF {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        // Markers without a length: TEM, RSTn, SOI.
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            continue;
        }
        // End of image or start of scan before any frame: no size here.
        if marker == 0xD9 || marker == 0xDA {
            return None;
        }
        let length = be16(bytes, at)? as usize;
        if length < 2 {
            return None;
        }
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            return Some(PixelSize { height: be16(bytes, at + 3)?, width: be16(bytes, at + 5)? });
        }
        at += length;
    }
    None
}

/// Lossy (`VP8 `), lossless (`VP8L`) or extended (`VP8X`) WebP.
fn webp(bytes: &[u8]) -> Option<PixelSize> {
    match bytes.get(12..16)? {
        b"VP8 " => {
            (bytes.get(23..26)? == [0x9D, 0x01, 0x2A]).then_some(())?;
            Some(PixelSize { width: le16(bytes, 26)? & 0x3FFF, height: le16(bytes, 28)? & 0x3FFF })
        }
        b"VP8L" => {
            (*bytes.get(20)? == 0x2F).then_some(())?;
            let b = bytes.get(21..25)?;
            let (b0, b1, b2, b3) = (u32::from(b[0]), u32::from(b[1]), u32::from(b[2]), u32::from(b[3]));
            Some(PixelSize { width: 1 + (b0 | (b1 & 0x3F) << 8), height: 1 + (b1 >> 6 | b2 << 2 | (b3 & 0x0F) << 10) })
        }
        b"VP8X" => Some(PixelSize { width: 1 + le24(bytes, 24)?, height: 1 + le24(bytes, 27)? }),
        _ => None,
    }
}

/// An SVG's `width` and `height` in pixels (or without unit); a side it leaves out, or gives in
/// another unit, follows from the `viewBox`.
fn svg(bytes: &[u8]) -> Option<PixelSize> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(SVG_HEAD)]);
    // ASCII lowercasing keeps every byte where it was, so positions found here fit `head` too.
    let lower = head.to_ascii_lowercase();
    let start = lower.find("<svg")?;
    let rest = &head[start + 4..];
    // The tag ends at the first `>` outside quotes.
    let mut quote = None;
    let end = rest.char_indices().find_map(|(i, c)| {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if q == c => quote = None,
            (None, '>') => return Some(i),
            _ => {}
        }
        None
    })?;
    let attributes = attributes(&rest[..end]);
    let find = |name: &str| attributes.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, v)| *v);
    let width = find("width").and_then(pixels);
    let height = find("height").and_then(pixels);
    let view_box = find("viewbox").and_then(view_box);
    let (width, height) = match (width, height, view_box) {
        (Some(w), Some(h), _) => (w, h),
        (Some(w), None, Some((vw, vh))) if vw > 0.0 => (w, w * vh / vw),
        (None, Some(h), Some((vw, vh))) if vh > 0.0 => (h * vw / vh, h),
        (None, None, Some((vw, vh))) => (vw, vh),
        _ => return None,
    };
    let round =
        |value: f64| (value.is_finite() && value >= 0.5 && value < f64::from(u32::MAX)).then(|| value.round() as u32);
    Some(PixelSize { width: round(width)?, height: round(height)? })
}

/// `name="value"`, `name='value'` and `name=value` pairs of a tag.
fn attributes(tag: &str) -> Vec<(&str, &str)> {
    let mut found = Vec::new();
    let mut rest = tag;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '/');
        let Some(name_end) = rest.find(|c: char| c == '=' || c.is_whitespace()) else { break };
        let name = &rest[..name_end];
        rest = rest[name_end..].trim_start();
        let Some(after) = rest.strip_prefix('=') else {
            // A name without a value.
            if name.is_empty() {
                break;
            }
            continue;
        };
        rest = after.trim_start();
        let value;
        if let Some(q) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
            let inner = &rest[q.len_utf8()..];
            let Some(close) = inner.find(q) else { break };
            value = &inner[..close];
            rest = &inner[close + q.len_utf8()..];
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            value = &rest[..end];
            rest = &rest[end..];
        }
        if name.is_empty() {
            break;
        }
        found.push((name, value));
    }
    found
}

/// `120`, `120.5` or `120px`; any other unit (`%`, `em`, `cm`) is no pixel size.
fn pixels(value: &str) -> Option<f64> {
    let value = value.trim();
    let number = value.strip_suffix("px").unwrap_or(value).trim_end();
    number.parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0)
}

fn view_box(value: &str) -> Option<(f64, f64)> {
    let numbers: Vec<f64> = value
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .map_while(|s| s.parse().ok())
        .collect();
    match numbers[..] {
        [_, _, width, height] if width > 0.0 && height > 0.0 => Some((width, height)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: u32, height: u32) -> Option<PixelSize> {
        Some(PixelSize { width, height })
    }

    #[test]
    fn reads_png_and_gif_headers() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&1200u32.to_be_bytes());
        png.extend_from_slice(&600u32.to_be_bytes());
        assert_eq!(image_size(&png), size(1200, 600));
        assert_eq!(image_size(&png[..20]), None, "cut off before the height");

        let gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00";
        assert_eq!(image_size(gif), size(1, 1));
        assert_eq!(image_size(b"GIF89a\x58\x02\xc8\x00"), size(600, 200));
    }

    #[test]
    fn reads_jpeg_frames_after_other_segments() {
        let mut jpeg = vec![0xFF, 0xD8];
        // APP0 (JFIF) with 14 bytes of content, then padding, then SOF2 (progressive).
        jpeg.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        jpeg.extend_from_slice(&[0u8; 14]);
        jpeg.extend_from_slice(&[0xFF, 0xFF, 0xC2, 0x00, 0x11, 0x08, 0x01, 0xE0, 0x02, 0x80, 0x03]);
        assert_eq!(image_size(&jpeg), size(640, 480));

        // A Huffman table (C4) is no frame.
        let tables =
            [0xFF, 0xD8, 0xFF, 0xC4, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20];
        assert_eq!(image_size(&tables), size(32, 16));
        // Scan data before any frame, a broken length, a truncated file.
        assert_eq!(image_size(&[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x08]), None);
        assert_eq!(image_size(&[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x00]), None);
        assert_eq!(image_size(&[0xFF, 0xD8, 0xFF, 0xE1, 0x40, 0x00, 0x01]), None);
        assert_eq!(image_size(&[0xFF, 0xD8, 0x00]), None);
    }

    #[test]
    fn reads_every_kind_of_webp() {
        let riff = |chunk: &[u8]| {
            let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
            bytes.extend_from_slice(chunk);
            bytes
        };
        // Lossy: frame tag, start code, 14-bit sizes.
        let lossy = riff(b"VP8 \0\0\0\0\x30\x01\x00\x9d\x01\x2a\x20\x03\x58\x02");
        assert_eq!(image_size(&lossy), size(800, 600));
        // Lossless: 14 bits each, stored minus one.
        let (w, h) = (300u32 - 1, 150u32 - 1);
        let bits = w | h << 14;
        let mut lossless = b"VP8L\0\0\0\0\x2f".to_vec();
        lossless.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(image_size(&riff(&lossless)), size(300, 150));
        // Extended: 24-bit canvas, stored minus one.
        let extended = riff(b"VP8X\0\0\0\0\x10\0\0\0\x1f\x03\x00\x0f\x02\x00");
        assert_eq!(image_size(&extended), size(800, 528));
        assert_eq!(image_size(&riff(b"VP8 \0\0\0\0\x30\x01\x00\x00\x00\x00\x20\x03\x58\x02")), None);
        assert_eq!(image_size(&riff(b"ANIM")), None);
    }

    #[test]
    fn reads_svg_sizes_and_view_boxes() {
        assert_eq!(image_size(br#"<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200">"#), size(480, 200));
        assert_eq!(image_size(br#"<?xml version="1.0"?><SVG WIDTH='64px' Height=32 >"#), size(64, 32));
        assert_eq!(image_size(br#"<svg viewBox="0 0 960 540"><rect/></svg>"#), size(960, 540));
        assert_eq!(image_size(br#"<svg width="300" viewBox="0,0,960,540">"#), size(300, 169));
        assert_eq!(image_size(br#"<svg height="100%" viewBox="0 0 10 20">"#), size(10, 20));
        assert_eq!(image_size(br#"<svg data-x="a > b" width="12" height="7">"#), size(12, 7));
        // Multi-byte text before and inside the tag.
        assert_eq!(
            image_size("<!-- größe 🎉 --><svg aria-label=\"ü>\" width=\"5\" height=\"6\">".as_bytes()),
            size(5, 6)
        );
        assert_eq!(image_size(br#"<svg width="50%" height="2em">"#), None);
        assert_eq!(image_size(br#"<svg width="10""#), None, "the tag never ends");
        assert_eq!(image_size(b"<html><body>no picture</body></html>"), None);
        assert_eq!(image_size(br#"<svg width="0" height="10">"#), None);
    }

    #[test]
    fn survives_any_prefix_of_real_headers() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 1, 0, 0, 0, 1, 0]);
        let jpeg = [0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20];
        for bytes in [&png[..], &jpeg[..], b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\x10\0\0\0\x1f\x03\x00\x0f\x02\x00"] {
            for end in 0..bytes.len() {
                let _ = image_size(&bytes[..end]);
            }
        }
    }
}
