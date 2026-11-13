"use client";

import { CallDetail } from "@/components/call-detail";
import { useParams } from "next/navigation";

export default function CallPage() {
  const params = useParams<{ id: string }>();
  return <CallDetail id={params.id} />;
}
