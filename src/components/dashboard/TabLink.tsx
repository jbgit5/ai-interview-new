"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface TabLinkProps {
  href: string;
  label: string;
}

export default function TabLink({ href, label }: TabLinkProps) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        isActive
          ? "border-blue-600 text-blue-600"
          : "border-transparent text-gray-500 hover:text-gray-900 hover:border-gray-300"
      }`}
    >
      {label}
    </Link>
  );
}
