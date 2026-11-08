import { redirect } from "next/navigation";

/** Payouts are hidden: ClearAid tracks money, it doesn't move it. */
export default function Moved() {
  redirect("/");
}
