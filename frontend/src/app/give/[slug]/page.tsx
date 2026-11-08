import { GivePage } from "./GivePage";

export default async function Page({ params }: PageProps<"/give/[slug]">) {
  const { slug } = await params;
  return <GivePage slug={slug} />;
}
