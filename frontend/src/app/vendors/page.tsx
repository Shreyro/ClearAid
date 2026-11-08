import { redirect } from "next/navigation";

/** Payees (vendors) now live in Settings. */
export default function Moved() {
  redirect("/settings?tab=payees");
}
