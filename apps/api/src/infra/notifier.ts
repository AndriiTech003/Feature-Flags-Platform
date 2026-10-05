import { EventEmitter } from 'node:events';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { changesChannel, type ChangeNotification } from '@ashamrai/flags-contracts';
import type { AppConfig } from '../config';
import { outboxRedisChannel, type OutboxTopic } from '../outbox/outbox';
import { APP_CONFIG } from '../tokens';

@Injectable()
export class Notifier implements OnModuleDestroy {
  private readonly publisher: Redis;
  private subscriber: Redis | null = null;
  private readonly emitter = new EventEmitter();
  private readonly channel: string;
  private readonly prefix: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.channel = changesChannel(config.redisPrefix);
    this.prefix = config.redisPrefix;
    this.publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.publisher.on('error', () => undefined);
    this.emitter.setMaxListeners(0);
    this.subscriber = this.publisher.duplicate();
    this.subscriber.on('error', () => undefined);
    void this.subscriber.subscribe(this.channel).catch(() => undefined);
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== this.channel) return;
      try {
        this.emitter.emit('change', JSON.parse(message) as ChangeNotification);
      } catch {
        return;
      }
    });
  }

  async publish(topic: OutboxTopic, payload: string): Promise<void> {
    await this.publisher.publish(outboxRedisChannel(this.prefix, topic), payload);
  }

  onChange(listener: (notification: ChangeNotification) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  async onModuleDestroy(): Promise<void> {
    this.emitter.removeAllListeners();
    await Promise.allSettled([this.publisher.quit(), this.subscriber?.quit()]);
    this.subscriber = null;
  }
}
