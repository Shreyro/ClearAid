import { EmbedFrame } from "./EmbedFrame";

export default async function Page({ params }: PageProps<"/embed/[key]">) {
  const { key } = await params;
  return <EmbedFrame embedKey={key} />;
}
