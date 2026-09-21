create table `user` (`id` varchar(36) not null primary key, `name` varchar(255) not null, `email` varchar(255) not null unique, `emailVerified` boolean not null, `image` text, `createdAt` timestamp(3) default CURRENT_TIMESTAMP(3) not null, `updatedAt` timestamp(3) default CURRENT_TIMESTAMP(3) not null, `role` text, `banned` boolean, `banReason` text, `banExpires` timestamp(3), `twoFactorEnabled` boolean, `status` VARCHAR(16) NOT NULL DEFAULT 'enabled', `statusChangedAt` TIMESTAMP(3) NULL, `statusChangedBy` VARCHAR(36) NULL, `statusReason` TEXT NULL, `statusExpiresAt` TIMESTAMP(3) NULL, `emailVerifiedAt` TIMESTAMP(3) NULL, `manuallyVerifiedAt` TIMESTAMP(3) NULL, `manuallyVerifiedBy` VARCHAR(36) NULL, `legacyVerificationRecordedAt` TIMESTAMP(3) NULL);

create table `session` (`id` varchar(36) not null primary key, `expiresAt` timestamp(3) not null, `token` varchar(255) not null unique, `createdAt` timestamp(3) default CURRENT_TIMESTAMP(3) not null, `updatedAt` timestamp(3) not null, `ipAddress` text, `userAgent` text, `userId` varchar(36) not null references `user` (`id`) on delete cascade, `impersonatedBy` text);

create table `account` (`id` varchar(36) not null primary key, `accountId` text not null, `providerId` text not null, `userId` varchar(36) not null references `user` (`id`) on delete cascade, `accessToken` text, `refreshToken` text, `idToken` text, `accessTokenExpiresAt` timestamp(3), `refreshTokenExpiresAt` timestamp(3), `scope` text, `password` text, `createdAt` timestamp(3) default CURRENT_TIMESTAMP(3) not null, `updatedAt` timestamp(3) not null);

create table `verification` (`id` varchar(36) not null primary key, `identifier` varchar(255) not null, `value` text not null, `expiresAt` timestamp(3) not null, `createdAt` timestamp(3) default CURRENT_TIMESTAMP(3) not null, `updatedAt` timestamp(3) default CURRENT_TIMESTAMP(3) not null);

create table `twoFactor` (`id` varchar(36) not null primary key, `secret` varchar(255) not null, `backupCodes` text not null, `userId` varchar(36) not null references `user` (`id`) on delete cascade, `verified` boolean, `failedVerificationCount` integer, `lockedUntil` timestamp(3));

create table `passkey` (`id` varchar(36) not null primary key, `name` text, `publicKey` text not null, `userId` varchar(36) not null references `user` (`id`) on delete cascade, `credentialID` varchar(255) not null, `counter` integer not null, `deviceType` text not null, `backedUp` boolean not null, `transports` text, `createdAt` timestamp(3), `aaguid` text);

create table `rateLimit` (`id` varchar(36) not null primary key, `key` varchar(255) not null unique, `count` integer not null, `lastRequest` bigint not null);

create index `session_userId_idx` on `session` (`userId`);

create index `account_userId_idx` on `account` (`userId`);

create index `verification_identifier_idx` on `verification` (`identifier`);

create index `twoFactor_secret_idx` on `twoFactor` (`secret`);

create index `twoFactor_userId_idx` on `twoFactor` (`userId`);

create index `passkey_userId_idx` on `passkey` (`userId`);

create index `passkey_credentialID_idx` on `passkey` (`credentialID`);