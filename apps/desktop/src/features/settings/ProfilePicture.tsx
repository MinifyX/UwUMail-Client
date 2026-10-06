import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useState } from "react";
import { backend, BackendError } from "@/backend/backend";
import type { PictureVisibility, ProfilePictureOptions } from "@/backend/types";
import { Toggle } from "@uwusuite/design";
import { useT } from "@/i18n";
import { initials } from "@/lib/format";
import { PROFILE_PICTURE, renderPictureBlob, type Crop, type Picture } from "@/lib/pictures";
import { queryKeys, refreshSenderPictures, useAccounts } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { CROP_VIEW } from "../pictures/PictureCropDialog";
import { PictureField } from "../pictures/PictureField";
import { Row } from "./Row";

export function useProfilePicture(accountId: string) {
  return useQuery({
    queryKey: queryKeys.profilePicture(accountId),
    queryFn: () => backend().profilePicture(accountId),
  });
}

/** The server's refusal in words; its own text is for administrators. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const VISIBILITIES: PictureVisibility[] = ["off", "server", "public"];

/**
 * Settings → Profile picture: the own picture, who sees it, and whether mails carry it. Only
 * for mailboxes whose UwUMail server keeps profile pictures (its profile extension); `options`
 * are what that server allows.
 */
export function ProfilePictureSettings({ accountId, options }: { accountId: string; options: ProfilePictureOptions }) {
  const { t } = useT();
  const client = useQueryClient();
  const { data: profile, isError } = useProfilePicture(accountId);
  const { data: accounts = [] } = useAccounts();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const me = accounts.find((account) => account.id === accountId);

  // Your own picture shows as a sender picture too, so avatars ask again right away.
  const refresh = () => {
    void refreshSenderPictures(client);
    return client.invalidateQueries({ queryKey: queryKeys.profilePicture(accountId) });
  };

  const store = async (picture: Blob | null) => {
    setBusy(true);
    try {
      await backend().setProfilePicture(accountId, picture);
      toast(t(picture ? "profile.saved" : "profile.removed"), "success");
    } catch (error) {
      toast(t("profile.failed", { reason: errorText(error) }), "error");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const cropped = async (picture: Picture, crop: Crop) => {
    let blob: Blob;
    try {
      blob = await renderPictureBlob(picture, crop, CROP_VIEW, PROFILE_PICTURE);
    } finally {
      picture.close();
    }
    await store(blob);
  };

  const update = async (patch: { visibility?: PictureVisibility; sendFace?: boolean }) => {
    setSaving(true);
    try {
      await backend().updateProfilePicture(accountId, patch);
    } catch (error) {
      const forbidden = error instanceof BackendError && error.code === "forbidden";
      toast(forbidden ? t("profile.publicForbidden") : t("profile.failed", { reason: errorText(error) }), "error");
    } finally {
      setSaving(false);
      await refresh();
    }
  };

  if (!profile) {
    return (
      <p role="status" className="py-8 text-center text-[13px] text-muted">
        {isError ? t("profile.loadFailed") : t("profile.loading")}
      </p>
    );
  }

  const isPublic = profile.visibility === "public";

  return (
    <>
      <Row label={t("profile.picture")} description={t("profile.pictureDesc")}>
        <PictureField
          large
          src={profile.url}
          hasPicture={profile.url !== null}
          busy={busy}
          placeholder={
            me ? (
              <span className="text-[26px] font-bold" aria-hidden>
                {initials({ name: me.displayName, email: me.email })}
              </span>
            ) : undefined
          }
          onCropped={cropped}
          onRemove={() => void store(null)}
        />
      </Row>
      <Row label={t("profile.visibility")}>
        <div role="radiogroup" aria-label={t("profile.visibility")} className="flex flex-col gap-1.5">
          {VISIBILITIES.map((visibility) => {
            const forbidden = visibility === "public" && !options.mayBePublic && profile.visibility !== "public";
            const chosen = profile.visibility === visibility;
            return (
              <button
                key={visibility}
                type="button"
                role="radio"
                aria-checked={chosen}
                disabled={forbidden || saving}
                onClick={() => !chosen && void update({ visibility })}
                className={clsx(
                  "flex items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:opacity-55",
                  chosen ? "border-pink bg-pink-tint/50" : "border-line hover:bg-elevated",
                )}
              >
                <span
                  aria-hidden
                  className={clsx(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2",
                    chosen ? "border-pink" : "border-faint",
                  )}
                >
                  {chosen && <span className="size-2 rounded-full bg-pink" />}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13.5px] font-semibold">{t(`profile.${visibility}.title`)}</span>
                  <span className="text-[12.5px] text-muted">{t(`profile.${visibility}.body`)}</span>
                </span>
              </button>
            );
          })}
        </div>
        {!options.mayBePublic && <p className="text-[12.5px] text-muted">{t("profile.publicForbidden")}</p>}
      </Row>
      <div className="border-b border-hairline py-4 last:border-0">
        <Toggle
          checked={profile.sendFace && isPublic}
          disabled={!isPublic || saving}
          onChange={(sendFace) => void update({ sendFace })}
          label={t("profile.face")}
          description={t("profile.faceDesc")}
        />
      </div>
    </>
  );
}
