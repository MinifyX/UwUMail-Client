import { useState } from "react";
import type { EventDeleteScope } from "@/backend/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { answerDeleteScope, useCalendarUi } from "./state";

/** Deleting a repeating event: only this one, or every one of the series? */
export function DeleteScopeQuestion() {
  const question = useCalendarUi((s) => s.deleteScope);
  const cancel = () => answerDeleteScope(null);
  return (
    <Dialog open={question !== null} onClose={cancel} width="sm">
      {question && <ScopeChoice key={question.title} title={question.title} onCancel={cancel} />}
    </Dialog>
  );
}

function ScopeChoice({ title, onCancel }: { title: string; onCancel: () => void }) {
  const { t } = useT();
  const [scope, setScope] = useState<EventDeleteScope>("occurrence");
  return (
    <form
      className="flex flex-col gap-4 px-6 pt-5 pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        answerDeleteScope(scope);
      }}
    >
      <div>
        <h2 className="text-[18px] font-extrabold">{t("calendar.deleteScope.title")}</h2>
        <p className="truncate text-[13px] text-muted">{title || t("calendar.untitled")}</p>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">{t("calendar.deleteScope.title")}</legend>
        {(["occurrence", "series"] as const).map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-pink-tint/50"
          >
            <input
              type="radio"
              name="scope"
              value={option}
              checked={scope === option}
              onChange={() => setScope(option)}
              className="size-4 accent-pink"
              autoFocus={option === "occurrence"}
            />
            {t(`calendar.deleteScope.${option}`)}
          </label>
        ))}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="danger">
          {t("calendar.delete")}
        </Button>
      </div>
    </form>
  );
}
