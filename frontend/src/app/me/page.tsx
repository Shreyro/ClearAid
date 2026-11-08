import { redirect } from "next/navigation";

/** Removed page (donor / vendor views are gone); send old links and bookmarks to the app. */
export default function Removed() {
  redirect("/");
}
