import { FundPage } from "./FundPage";

export default async function Page({ params }: PageProps<"/funds/[slug]">) {
  const { slug } = await params;
  return <FundPage slug={slug} />;
}
