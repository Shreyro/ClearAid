import { SpendDetail } from "./SpendDetail";

export default async function Page({ params }: PageProps<"/spend/[id]">) {
  const { id } = await params;
  return <SpendDetail id={id} />;
}
