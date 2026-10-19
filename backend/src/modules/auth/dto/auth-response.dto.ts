import { ApiProperty } from '@nestjs/swagger';
import {
  ROLE_VALUES,
  type Role,
  type AuthenticatedUser,
} from '../../../common/auth.types';

export class AuthUserDto implements AuthenticatedUser {
  @ApiProperty() id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: [...ROLE_VALUES] }) role!: Role;
  @ApiProperty() isActive!: boolean;
}

export class LoginResponseDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ enum: ['Bearer'] }) tokenType!: 'Bearer';
  @ApiProperty({
    example: 900,
    description: 'Access token lifetime in seconds',
  })
  expiresIn!: number;
  @ApiProperty({ type: AuthUserDto }) user!: AuthUserDto;
}
