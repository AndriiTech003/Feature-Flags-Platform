import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui/primitives';
import { API_URL, errorMessage, post, setToken } from '@/lib/api';

const schema = z.object({ email: z.email(), password: z.string().min(1, 'required') });

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: 'demo@demo.dev', password: 'demo1234' },
  });
  useEffect(() => {
    const match = /token=([^&]+)/.exec(location.hash);
    if (match) {
      setToken(decodeURIComponent(match[1]!));
      void navigate({ to: '/' });
    }
  }, [navigate]);
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const session = await post<{ token: string }>('/auth/login', values);
      setToken(session.token);
      await navigate({ to: '/' });
    } catch (e) {
      setError(errorMessage(e));
    }
  });
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-50 to-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="size-8" />
            <span className="text-lg font-semibold">Flags</span>
          </div>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Demo account: demo@demo.dev / demo1234</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                data-testid="login-email"
                autoComplete="username"
                {...form.register('email')}
              />
              {form.formState.errors.email ? (
                <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                data-testid="login-password"
                autoComplete="current-password"
                {...form.register('password')}
              />
            </div>
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            <Button type="submit" data-testid="login-submit" disabled={form.formState.isSubmitting}>
              Sign in
            </Button>
            <Button variant="outline" type="button" onClick={() => location.assign(`${API_URL}/auth/github`)}>
              Continue with GitHub
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
