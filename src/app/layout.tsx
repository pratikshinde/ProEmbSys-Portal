import type { Metadata } from "next";
import { DM_Sans, DM_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import AppSessionProvider from "@/components/session-provider";
import AppQueryProvider from "@/components/query-provider";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "ProPCB — Advanced PCB Fabrication & Assembly Portal",
  description: "High-quality, quick-turn PCB prototype and production manufacturing. Professional Gerber panelization, turnkey assembly, and custom fabrication.",
  keywords: ["PCB", "Printed Circuit Board", "Panelization", "Gerber", "CAM", "SMT", "Assembly", "Electronics"],
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${dmSans.variable} ${dmMono.variable} antialiased bg-[#061628] text-[#f0f8ff]`}
        style={{ colorScheme: 'dark', fontFamily: "var(--font-dm-sans), sans-serif" }}
        suppressHydrationWarning
      >
        <AppSessionProvider>
          <AppQueryProvider>
            {children}
            <Toaster />
          </AppQueryProvider>
        </AppSessionProvider>
      </body>
    </html>
  );
}
