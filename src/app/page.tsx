import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import App from '@/components/portal-main'

export default async function Home() {
  // Operators have no use for the marketing site / customer tools — send them
  // straight to their work queue.
  const session = await auth()
  if (session?.user?.role === 'OPERATOR') redirect('/production')

  return <App />
}
