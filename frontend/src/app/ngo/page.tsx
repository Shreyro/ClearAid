import { redirect } from "next/navigation";

/** The old NGO console URL now lives at the app root. */
export default function OldConsole() {
  redirect("/");
}
