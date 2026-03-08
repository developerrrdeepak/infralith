'use client';
import InfralithShellLayout from "@/components/infralith/shell/layout";
import PageLoader from "@/components/infralith/shell/page-loader";
import { useAppContext } from "@/contexts/app-context";

export default function Home() {
  const { isLoadingAuth, isProfileChecked } = useAppContext();

  // Show loader while authentication is initializing
  if (isLoadingAuth || !isProfileChecked) {
    return <PageLoader />;
  }

  // Once authentication is resolved, show the full Infralith platform
  return <InfralithShellLayout />;
}
