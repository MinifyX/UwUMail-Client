import { forwardRef, useState, type ComponentProps } from "react";
import { armedActivation } from "./armed";
import { Button } from "./Button";

type ArmedButtonProps = Omit<ComponentProps<typeof Button>, "onClick" | "onKeyDown"> & { onClick: () => void };

/**
 * The button that answers a destructive question (delete, empty for good). It ignores the click
 * and the held-down key of the gesture that opened the question, e.g. Enter held on a menu item
 * that goes on into the question's focused button (security-audit C-10, webmail W-24). Mount it
 * with the question, so the arming starts when the question shows.
 */
export const ArmedButton = forwardRef<HTMLButtonElement, ArmedButtonProps>(function ArmedButton(
  { onClick, ...rest },
  ref,
) {
  const [shownAt] = useState(() => performance.now());
  return <Button ref={ref} {...rest} {...armedActivation(shownAt, onClick)} />;
});
