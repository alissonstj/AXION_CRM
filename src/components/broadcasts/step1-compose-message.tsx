'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BroadcastMediaType } from '@/types';

interface Step1ComposeProps {
  text: string;
  onTextChange: (text: string) => void;
  mediaUrl: string;
  onMediaUrlChange: (url: string) => void;
  mediaType: BroadcastMediaType | null;
  onMediaTypeChange: (type: BroadcastMediaType | null) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_TYPES: BroadcastMediaType[] = ['image', 'video', 'document', 'audio'];

export function Step1ComposeMessage({
  text,
  onTextChange,
  mediaUrl,
  onMediaUrlChange,
  mediaType,
  onMediaTypeChange,
  onNext,
  onBack,
}: Step1ComposeProps) {
  const t = useTranslations('Broadcasts.wizard');
  const canProceed = text.trim().length > 0 || mediaUrl.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('composeMessage.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('composeMessage.subtitle')}</p>
      </div>

      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <label className="block text-sm font-medium text-foreground">
          {t('composeMessage.textLabel')}
        </label>
        <Textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t('composeMessage.textPlaceholder')}
          rows={5}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <p className="text-xs text-muted-foreground">{t('composeMessage.textHint')}</p>
      </div>

      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <label className="block text-sm font-medium text-foreground">
          {t('composeMessage.mediaLabel')}
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
          <Select
            value={mediaType ?? undefined}
            onValueChange={(val) => onMediaTypeChange((val || null) as BroadcastMediaType | null)}
          >
            <SelectTrigger className="w-full border-border bg-muted text-foreground">
              <SelectValue placeholder={t('composeMessage.mediaTypeLabel')} />
            </SelectTrigger>
            <SelectContent className="border-border bg-popover">
              {MEDIA_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="url"
            value={mediaUrl}
            onChange={(e) => {
              const url = e.target.value;
              onMediaUrlChange(url);
              if (url.trim() && !mediaType) onMediaTypeChange('image');
              if (!url.trim()) onMediaTypeChange(null);
            }}
            placeholder={t('composeMessage.mediaUrlPlaceholder')}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {!canProceed && (
        <p className="text-xs text-amber-300">{t('composeMessage.errorEmpty')}</p>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!canProceed}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
