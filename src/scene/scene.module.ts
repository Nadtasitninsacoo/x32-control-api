import { Module } from '@nestjs/common';
import { ApplyModule } from '../apply/apply.module.js';
import { ConsoleModule } from '../console/console.module.js';
import { SceneController } from './scene.controller.js';
import { SceneService } from './scene.service.js';

/** Scenes, cues and snippets on the console, and the .scn file format. */
@Module({
  imports: [ConsoleModule, ApplyModule],
  controllers: [SceneController],
  providers: [SceneService],
  exports: [SceneService],
})
export class SceneModule {}
