import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { RedisService } from '../../common/redis/redis.service';

// Real-time notifications over WebSocket (socket.io).
@WebSocketGateway({
  cors: {
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  },
})
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnApplicationShutdown
{
  private readonly logger = new Logger(NotificationsGateway.name);

  /**
   * Two dedicated connections, not the shared client.
   *
   * A Redis connection in subscriber mode may not issue ordinary commands, so
   * the adapter needs one socket to publish on and a second to subscribe with.
   * Borrowing RedisService's client for either would break every counter that
   * also uses it.
   */
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Share the rooms between replicas.
   *
   * `emitToUser` below sends into a per-user room, and a room lives in the
   * memory of one Node process. With a second replica and no adapter, a
   * notification emitted by replica A never reaches a user whose socket is held
   * by replica B — roughly half of them vanish, with nothing logged anywhere to
   * say so. That silence is why this is wired at boot rather than left as a
   * deployment note.
   *
   * Without Redis the adapter is skipped and the gateway behaves exactly as it
   * did before: correct for one replica, and the warning says what happens with
   * two.
   */
  afterInit(server: Server): void {
    const client = this.redis.client;
    if (!client) {
      this.logger.warn(
        'No Redis — notification rooms are local to this process. Correct for ' +
          'one replica; with two, a notification reaches only the replica ' +
          'holding that socket.',
      );
      return;
    }

    this.pub = client.duplicate();
    this.sub = client.duplicate();
    // An error listener is mandatory on each: ioredis promotes an unhandled
    // 'error' to an uncaught exception and takes the process down.
    this.pub.on('error', (err) => this.logger.error(`pub: ${err.message}`));
    this.sub.on('error', (err) => this.logger.error(`sub: ${err.message}`));

    server.adapter(createAdapter(this.pub, this.sub));
    this.logger.log('Notification rooms shared across replicas via Redis');
  }

  // Authenticate the handshake with the access token, then put the socket in a
  // per-user room so we can target individual users.
  handleConnection(client: Socket) {
    try {
      const raw =
        (client.handshake.auth?.token as string | undefined) ??
        client.handshake.headers.authorization?.replace('Bearer ', '');

      if (!raw) throw new Error('No token');

      const payload = this.jwt.verify<{ sub: string }>(raw, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });

      void client.join(this.room(payload.sub));
    } catch {
      client.disconnect();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.pub?.quit().catch(() => undefined),
      this.sub?.quit().catch(() => undefined),
    ]);
  }

  // Push a payload to every open socket belonging to a user, on any replica.
  emitToUser(userId: string, event: string, data: unknown) {
    this.server.to(this.room(userId)).emit(event, data);
  }

  private room(userId: string) {
    return `user:${userId}`;
  }

  @WebSocketServer()
  server: Server;
}
