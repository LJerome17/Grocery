import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { AppProvider } from "@/components/AppProvider";
import { BottomNav } from "@/components/BottomNav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Momo et Jéjé cuisinent végé",
  description: "Recettes de la semaine et liste d'épicerie automatique",
  applicationName: "Momo et Jéjé cuisinent végé",
  appleWebApp: { capable: true, title: "Momo & Jéjé", statusBarStyle: "default" },
  icons: { icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/favicon-48.png", sizes: "48x48" }, { url: "/icon-192.png", sizes: "192x192" }], apple: "/apple-touch-icon.png" },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#2f6b3a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr-CA" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AppProvider>
          <main className="mx-auto max-w-xl px-4 pb-28 pt-4">{children}</main>
          <BottomNav />
        </AppProvider>
      </body>
    </html>
  );
}
