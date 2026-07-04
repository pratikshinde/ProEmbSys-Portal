import Link from "next/link"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-16">
      <Link href="/" className="mb-8 text-lg font-bold tracking-tight text-foreground">
        Pro<span className="text-primary">PCB</span>
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
