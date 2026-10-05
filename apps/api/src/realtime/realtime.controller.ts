import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessService } from '../access/access.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { Notifier } from '../infra/notifier';

@Controller()
export class RealtimeController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  @Get('projects/:p/stream')
  async stream(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const project = await this.access.project(user, p);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`event: ready\ndata: ${JSON.stringify({ project: project.key })}\n\n`);
    const unsubscribe = this.notifier.onChange((notification) => {
      if (notification.projectId !== project.id) return;
      res.write(`event: change\ndata: ${JSON.stringify(notification)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}
