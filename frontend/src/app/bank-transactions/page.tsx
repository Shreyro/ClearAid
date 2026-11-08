import { redirect } from "next/navigation";

/** Bank tagging moved to Untagged. */
export default function Moved() {
  redirect("/untagged");
}
