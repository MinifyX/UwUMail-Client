import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { useContactsUi } from "./state";
import { useContactActions } from "./useContactsData";

/** "Really delete?" for one contact: it goes from every device that syncs the address book. */
export function DeleteContactQuestion() {
  const { t } = useT();
  const contact = useContactsUi((s) => s.deleting);
  const askDelete = useContactsUi((s) => s.askDelete);
  const actions = useContactActions();
  return (
    <Dialog open={contact !== null} onClose={() => askDelete(null)} width="sm">
      {contact && (
        <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
          <NyuScene name="goodbye" className="w-36" />
          <h2 className="text-[18px] font-extrabold text-balance">
            {t("contacts.deleteTitle", { name: contact.displayName || t("contacts.nameless") })}
          </h2>
          <p className="text-[13px] text-muted">{t("contacts.deleteBody")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button
              variant="danger"
              autoFocus
              onClick={() => {
                askDelete(null);
                void actions.remove(contact);
              }}
            >
              {t("contacts.delete")}
            </Button>
            <Button variant="ghost" onClick={() => askDelete(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
