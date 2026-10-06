import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'LeadGen | Your business lead workspace', description: 'Find businesses, collect public contacts, and build your next customer list.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
