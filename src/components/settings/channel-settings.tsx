'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { SettingsPanelHead } from './settings-panel-head';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { MetaConfig } from './meta-config';
import { EvolutionConnect } from './evolution-connect';

type Provider = 'meta' | 'evolution';

export function ChannelSettings() {
  const t = useTranslations('Settings.whatsapp');
  const { accountId, loading: authLoading, profileLoading } = useAuth();
  const supabase = createClient();
  const [provider, setProvider] = useState<Provider>('meta');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId || loaded) return;
    supabase
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', accountId)
      .maybeSingle()
      .then(({ data }) => {
        // Rows written before migration 037 have no `provider` column
        // value cached client-side yet — default to 'meta', matching
        // the migration's own DEFAULT 'meta'.
        setProvider((data?.provider as Provider) ?? 'meta');
        setLoaded(true);
      });
  }, [authLoading, profileLoading, accountId, loaded, supabase]);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Tabs value={provider} onValueChange={(v) => setProvider(v as Provider)} className="mt-6">
        <TabsList>
          <TabsTrigger value="meta">{t('channelSelector.meta')}</TabsTrigger>
          <TabsTrigger value="evolution">{t('channelSelector.evolution')}</TabsTrigger>
        </TabsList>
        <TabsContent value="meta">
          <MetaConfig />
        </TabsContent>
        <TabsContent value="evolution">
          <EvolutionConnect />
        </TabsContent>
      </Tabs>
    </section>
  );
}
