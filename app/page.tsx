import type { Metadata } from 'next';

const title = 'Pelican Test — Compare AI Model Animations';
const description = 'Watch AI models animate a pelican riding a bicycle. Compare saved SVG animations side by side, without signing in or entering an API key.';
export const metadata: Metadata = {
  title, description,
  alternates: { canonical: '/' },
  openGraph: { title, description, url: '/', type: 'website', images: [{ url: '/pelican-og.png', width: 1200, height: 630, alt: 'Pelican Test: one prompt, different models' }] },
  twitter: { card: 'summary_large_image', title, description, images: ['/pelican-og.png'] },
};
export default function Home() { return null; }
