import { redirect } from "next/navigation";

/** Bank accounts moved to Sources. */
export default function Moved() {
  redirect("/sources");
}
