//! `Windows.Media.Ocr` on Windows 10 and 11, in the first of the user's languages that has a
//! recognizer installed (English and the system language usually do). Pictures bigger than the
//! recognizer takes are shrunk first.

use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
    ExifOrientationMode,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

pub fn available() -> bool {
    OcrEngine::TryCreateFromUserProfileLanguages().is_ok()
}

pub fn recognize(image: &[u8]) -> Result<String, String> {
    read(image).map_err(|error| format!("Windows couldn't read the picture: {error}"))
}

fn read(image: &[u8]) -> windows::core::Result<String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;

    let writer = DataWriter::new()?;
    writer.WriteBytes(image)?;
    let stream = InMemoryRandomAccessStream::new()?;
    stream.WriteAsync(&writer.DetachBuffer()?)?.get()?;
    stream.Seek(0)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;

    let transform = BitmapTransform::new()?;
    let (width, height) = (decoder.PixelWidth()?, decoder.PixelHeight()?);
    let limit = OcrEngine::MaxImageDimension()?;
    let longer = width.max(height);
    if longer > limit && longer > 0 {
        let scale = |side: u32| ((u64::from(side) * u64::from(limit)) / u64::from(longer)).max(1) as u32;
        transform.SetScaledWidth(scale(width))?;
        transform.SetScaledHeight(scale(height))?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    }
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .get()?;

    let result = engine.RecognizeAsync(&bitmap)?.get()?;
    let mut lines = Vec::new();
    for line in result.Lines()? {
        lines.push(line.Text()?.to_string_lossy());
    }
    Ok(lines.join("\n"))
}
