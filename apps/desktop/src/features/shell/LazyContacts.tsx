import { lazy, Suspense, useState } from "react";
import { useContactsUi } from "../contacts/state";

// The contacts load when they are first opened, so the mail starts no slower for them.
const ContactsShell = lazy(() =>
  import("../contacts/ContactsShell").then((module) => ({ default: module.ContactsShell })),
);
const ContactEditor = lazy(() =>
  import("../contacts/ContactEditor").then((module) => ({ default: module.ContactEditor })),
);
const DeleteContactQuestion = lazy(() =>
  import("../contacts/DeleteContactQuestion").then((module) => ({ default: module.DeleteContactQuestion })),
);

/** The contacts in place of the mail (see ContactsShell). */
export function LazyContacts() {
  return (
    <Suspense fallback={null}>
      <ContactsShell />
    </Suspense>
  );
}

/**
 * The contact editor and "really delete?", for the contacts and the mail ("add to contacts"),
 * loaded once one of them is first asked for.
 */
export function LazyContactDialogs() {
  const wanted = useContactsUi((s) => s.editor !== null || s.deleting !== null);
  // Once loaded they stay, so a dialog can close the way it opened.
  const [loaded, setLoaded] = useState(false);
  if (wanted && !loaded) setLoaded(true);
  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <ContactEditor />
      <DeleteContactQuestion />
    </Suspense>
  );
}
