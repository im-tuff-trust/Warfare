import type { Metadata, Viewport } from 'next';
import { Black_Ops_One, Oswald } from 'next/font/google';
import './globals.css';

const title = Black_Ops_One({ subsets: ['latin'], weight: '400', variable: '--font-title' });
const ui = Oswald({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-ui' });

export const metadata: Metadata = {
  title: 'WARFARE: Steel & Sky',
  description: 'Browser-based 3D WWII tank and aircraft combat with realistic crew and armor damage.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#14160f' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${title.variable} ${ui.variable}`}>
      <body>{children}</body>
    </html>
  );
}
