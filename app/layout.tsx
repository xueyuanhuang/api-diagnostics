import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { SiteWorkspace } from '@/components/site-workspace';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://api-diagnostics.xue-yuanhuang.workers.dev'),
  title: 'API Diagnostics',
  description:
    'Check API token usage and measure staged request-rate capacity with saved evidence.',
  openGraph: {
    title: 'API Diagnostics',
    description: 'Inspect token usage and run staged RPM capacity tests.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'API Diagnostics dashboard',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'API Diagnostics',
    description: 'Inspect token usage and run staged RPM capacity tests.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SiteWorkspace>{children}</SiteWorkspace>
      </body>
    </html>
  );
}
