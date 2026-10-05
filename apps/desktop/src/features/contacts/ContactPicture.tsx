import { Building2 } from "lucide-react";
import { useState } from "react";
import { backend } from "@/backend/backend";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { CONTACT_PHOTO, renderPicture, type Crop, type Picture } from "@/lib/pictures";
import { toast } from "@/state/toasts";
import { CROP_VIEW } from "../pictures/PictureCropDialog";
import { PictureField } from "../pictures/PictureField";

/**
 * The contact's picture in the editor: everything PictureField offers, plus the company logo of
 * the contact's first address. What comes out is a small square JPEG that goes into the card.
 */
export function ContactPictureField({
  photo,
  src,
  email,
  onChange,
}: {
  /** The picture the contact will have, as stored, or null. */
  photo: string | null;
  /** Where the circle shows it from; null while there is nothing to show. */
  src: string | null;
  /** The address whose company logo can be taken, if any. */
  email: string | null;
  onChange: (photo: string | null) => void;
}) {
  const { t } = useT();
  const [logoBusy, setLogoBusy] = useState(false);
  const domain = email?.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";

  const takeLogo = async (open: (file: Blob) => void) => {
    if (!email) return;
    setLogoBusy(true);
    try {
      const logo = await backend().companyLogo(email);
      if (logo) open(logo);
      else toast(t("contacts.picture.noLogo", { domain }), "info");
    } finally {
      setLogoBusy(false);
    }
  };

  const cropped = (picture: Picture, crop: Crop) => {
    try {
      onChange(renderPicture(picture, crop, CROP_VIEW, CONTACT_PHOTO));
    } finally {
      picture.close();
    }
  };

  return (
    <PictureField
      src={src}
      hasPicture={photo !== null}
      onCropped={cropped}
      onRemove={() => onChange(null)}
      extra={(open) =>
        domain && (
          <Button size="sm" icon={Building2} busy={logoBusy} onClick={() => void takeLogo(open)}>
            {t("contacts.picture.logo")}
          </Button>
        )
      }
    />
  );
}
