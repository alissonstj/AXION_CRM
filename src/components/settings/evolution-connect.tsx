'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, XCircle, QrCode } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type Status = 'connected' | 'connecting' | 'disconnected' | 'error';
interface StateResponse {
  status: Status;
  qrCode: string | null;
  qrUpdatedAt: string | null;
  detail: string | null;
}

const POLL_INTERVAL_MS = 3000;

export function EvolutionConnect() {
  const t = useTranslations('Settings.whatsapp.evolution');
  const [state, setState] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/channels/evolution/state');
      const data = (await res.json()) as StateResponse;
      setState(data);
      return data;
    } catch (err) {
      console.error('Failed to fetch Evolution state:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const data = await fetchState();
      // Stop as soon as we leave the connecting state — matches the
      // approved design ("para assim que virar connected, error, ou o
      // componente desmontar").
      if (data && data.status !== 'connecting') stopPolling();
    }, POLL_INTERVAL_MS);
  }, [fetchState, stopPolling]);

  useEffect(() => {
    fetchState().then((data) => {
      if (data?.status === 'connecting') startPolling();
    });
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await fetch('/api/channels/evolution/connect', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to start connection');
        return;
      }
      await fetchState();
      startPolling();
    } catch (err) {
      console.error('Connect failed:', err);
      toast.error('Failed to start connection');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/channels/evolution/connect', { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to disconnect');
        return;
      }
      stopPolling();
      await fetchState();
      toast.success(t('disconnect'));
    } catch (err) {
      console.error('Disconnect failed:', err);
      toast.error('Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const status = state?.status ?? 'disconnected';

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      <Alert className="bg-card border-border">
        <div className="flex items-center gap-2">
          {status === 'connected' ? (
            <CheckCircle2 className="size-4 text-primary" />
          ) : status === 'error' ? (
            <XCircle className="size-4 text-red-500" />
          ) : (
            <QrCode className="size-4 text-muted-foreground" />
          )}
          <AlertTitle className="text-foreground mb-0">
            {status === 'connected' ? t('statusConnected')
              : status === 'connecting' ? t('statusConnecting')
              : status === 'error' ? t('statusError')
              : t('statusDisconnected')}
          </AlertTitle>
        </div>
        {status === 'error' && state?.detail && (
          <AlertDescription className="text-muted-foreground">{state.detail}</AlertDescription>
        )}
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'connecting' && state?.qrCode && (
            <div className="flex flex-col items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={state.qrCode} alt="QR code" className="size-64 rounded border border-border" />
              <p className="text-sm text-muted-foreground text-center max-w-xs">{t('scanHint')}</p>
            </div>
          )}

          <div className="flex gap-3">
            {status !== 'connected' && (
              <Button onClick={handleConnect} disabled={connecting || status === 'connecting'}>
                {connecting || status === 'connecting' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('connecting')}
                  </>
                ) : (
                  t('connect')
                )}
              </Button>
            )}
            {status === 'connected' && (
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('disconnecting')}
                  </>
                ) : (
                  t('disconnect')
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
