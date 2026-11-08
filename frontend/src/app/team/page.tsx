import { redirect } from "next/navigation";

/** Team now lives in Settings. */
export default function Moved() {
  redirect("/settings?tab=team");
}
