import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { ContactInput, ContactRecord } from "@/backend/types";
import { translate } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { useContactsUi } from "./state";

export function useContactsAvailable() {
  return useQuery({
    queryKey: ["contactsAvailable"],
    queryFn: () => backend().contactsAvailable(),
    staleTime: Infinity,
  });
}

/** Where the address books of each account come from, and why an account has none. */
export function useContactsAccounts() {
  return useQuery({ queryKey: queryKeys.contactsAccounts, queryFn: () => backend().contactsAccounts() });
}

export function useAddressBooks() {
  const client = useQueryClient();
  const { data: available = false } = useContactsAvailable();
  return useQuery({
    queryKey: queryKeys.addressBooks,
    queryFn: async () => {
      try {
        return await backend().addressBooks();
      } finally {
        // Listing them is what searches for CardDAV servers; now it is known whether there are any.
        void client.invalidateQueries({ queryKey: ["contactsAvailable"] });
      }
    },
    enabled: available,
  });
}

export function useContacts() {
  const client = useQueryClient();
  const { data: available = false } = useContactsAvailable();
  return useQuery({
    queryKey: queryKeys.contacts,
    queryFn: async () => {
      try {
        return await backend().contacts();
      } finally {
        void client.invalidateQueries({ queryKey: ["contactsAvailable"] });
      }
    },
    enabled: available,
  });
}

/**
 * The contacts already loaded, without loading them: reading them may search for CardDAV servers,
 * which waits until someone opens the contacts or the editor.
 */
export function useLoadedContacts() {
  return useQuery({ queryKey: queryKeys.contacts, queryFn: () => backend().contacts(), enabled: false });
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Saving and deleting contacts, with the toasts and the refresh after each. */
export function useContactActions() {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.contacts }),
      client.invalidateQueries({ queryKey: queryKeys.addressBooks }),
    ]);

  const create = async (input: ContactInput): Promise<boolean> => {
    try {
      const id = await backend().createContact(input);
      await refresh();
      const inContacts = useUi.getState().section === "contacts";
      if (inContacts) useContactsUi.getState().select(id);
      toast(
        translate("contacts.toast.created"),
        "success",
        undefined,
        inContacts
          ? undefined
          : {
              action: {
                label: translate("contacts.toast.show"),
                run: () => {
                  useUi.getState().setSection("contacts");
                  useContactsUi.getState().select(id);
                },
              },
            },
      );
      return true;
    } catch (error) {
      toast(translate("contacts.toast.failed", { reason: reason(error) }), "error");
      return false;
    }
  };

  const update = async (contact: ContactRecord, input: ContactInput): Promise<boolean> => {
    try {
      await backend().updateContact(contact.id, input);
      await refresh();
      toast(translate("contacts.toast.saved"), "success");
      return true;
    } catch (error) {
      toast(translate("contacts.toast.failed", { reason: reason(error) }), "error");
      await refresh();
      return false;
    }
  };

  const remove = async (contact: ContactRecord): Promise<boolean> => {
    try {
      await backend().deleteContact(contact.id);
      if (useContactsUi.getState().selectedId === contact.id) useContactsUi.getState().select(null);
      await refresh();
      toast(translate("contacts.toast.deleted", { name: contact.displayName }), "success");
      return true;
    } catch (error) {
      toast(translate("contacts.toast.failed", { reason: reason(error) }), "error");
      return false;
    }
  };

  return { create, update, remove, refresh };
}
