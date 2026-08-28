import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ROLES } from '../user.store.js';

export class LoginDto {
  @ApiProperty({ example: 'sam' })
  @IsString()
  @MaxLength(64)
  username!: string;

  @ApiProperty({ example: 'correct horse battery staple' })
  @IsString()
  @MaxLength(200)
  password!: string;
}

export class PrincipalDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'sam' })
  username!: string;

  @ApiProperty({ enum: ROLES, example: 'engineer' })
  role!: string;

  @ApiPropertyOptional({ example: 'Sam at FOH' })
  displayName?: string | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'True when authentication is off and this is the stand-in principal.',
  })
  anonymous?: boolean;
}

export class LoginResultDto {
  @ApiProperty({ description: 'Send as `Authorization: Bearer <token>`.' })
  accessToken!: string;

  @ApiProperty({ example: 43200, description: 'Token lifetime in seconds.' })
  expiresIn!: number;

  @ApiProperty({ type: PrincipalDto })
  user!: PrincipalDto;
}

export class CreateUserDto {
  @ApiProperty({ example: 'sam' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  username!: string;

  @ApiProperty({
    example: 'correct horse battery staple',
    description: 'At least 10 characters. This unlocks a PA system.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  password!: string;

  @ApiProperty({
    enum: ROLES,
    example: 'engineer',
    description:
      'admin manages users and safety; engineer mixes; observer can see everything and ' +
      'change nothing.',
  })
  @IsIn([...ROLES])
  role!: string;

  @ApiPropertyOptional({ example: 'Sam at FOH' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'a new long password' })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  password?: string;

  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn([...ROLES])
  role?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

export class UserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'sam' })
  username!: string;

  @ApiProperty({ enum: ROLES })
  role!: string;

  @ApiPropertyOptional()
  displayName?: string | null;

  @ApiProperty({ example: false })
  disabled!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiPropertyOptional({ description: 'When this account last signed in.' })
  lastLoginAt?: Date | null;
}
