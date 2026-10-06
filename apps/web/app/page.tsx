import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Dashboard from './workspace';
export const dynamic = 'force-dynamic';
export default function Page() {
  return <Dashboard extensionAvailable={existsSync(join(process.cwd(), 'public/downloads/leadgen-extension.zip'))} />;
}
