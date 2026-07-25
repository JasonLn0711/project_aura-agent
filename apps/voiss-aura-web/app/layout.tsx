import type { Metadata } from "next";
import "@copilotkit/react-ui/v2/styles.css";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "VOISS AURA Control Room",
  description: "從會議證據到可信任工程執行的本機控制平面",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant-TW">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
