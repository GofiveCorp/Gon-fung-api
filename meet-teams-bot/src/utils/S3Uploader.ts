import { spawn } from 'child_process'
import * as fs from 'fs'
import { GLOBAL } from '../singleton'
import 'dotenv/config';

// Singleton instance
let instance: S3Uploader | null = null

// Default S3 endpoint for Scaleway in fr-par region
const S3_ENDPOINT = process.env.S3_ENDPOINT || 's3.fr-par.scw.cloud'

export class S3Uploader {
    private constructor() {}

    public static getInstance(): S3Uploader {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 uploader - serverless mode')
            return null
        }

        if (!instance) {
            instance = new S3Uploader()
        }
        return instance
    }

    private async checkFileExists(filePath: string): Promise<void> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK)
        } catch (error) {
            throw new Error(`File does not exist: ${filePath}`)
        }
    }

    private getS3Args(s3Args?: string[]): string[] {
        // Order of precedence for s3Args:
        // 1. Provided s3Args argument (if non-empty)
        // 2. GLOBAL.get().remote?.s3_args (if non-empty)
        // 3. process.env.S3_ARGS (if set)
        // 4. []
        let finalS3Args: string[] = []
        if (s3Args && s3Args.length > 0) {
            finalS3Args = s3Args
        } else if (
            GLOBAL.get().remote?.s3_args &&
            GLOBAL.get().remote.s3_args.length > 0
        ) {
            finalS3Args = GLOBAL.get().remote.s3_args
        } else if (process.env.S3_ARGS) {
            finalS3Args = process.env.S3_ARGS.split(' ')
        }
        return finalS3Args
    }

    public async uploadFile(
        filePath: string,
        bucketName: string,
        s3Path: string,
        s3Args?: string[],
        isAudio: boolean = false,
    ): Promise<string> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return Promise.resolve('')
        }

        try {
            await this.checkFileExists(filePath)

            const s3FullPath = `s3://${bucketName}/${s3Path}`

            s3Args = this.getS3Args(s3Args)

            // Create the full command array
            const fullArgs = [
                ...s3Args,
                's3',
                'cp',
                filePath,
                s3FullPath,
                '--acl',
                'public-read',
            ]

            console.log('🔍 S3 upload command:', 'aws', fullArgs.join(' '))

            return new Promise((resolve, reject) => {
                const awsProcess = spawn('aws', fullArgs)
                let output = ''
                let errorOutput = ''

                awsProcess.stdout.on('data', (data) => {
                    output += data.toString()
                })

                awsProcess.stderr.on('data', (data) => {
                    errorOutput += data.toString()
                    console.error('S3 upload error:', data.toString().trim())
                })

                awsProcess.on('error', (error) => {
                    console.error(
                        'Failed to start AWS CLI process:',
                        error.message,
                    )
                    reject(
                        new Error(
                            `AWS CLI process failed to start: ${error.message}`,
                        ),
                    )
                })

                awsProcess.on('close', (code) => {
                    if (code === 0) {
                        const publicUrl = `https://${bucketName}.${S3_ENDPOINT}/${s3Path}`
                        resolve(publicUrl)
                    } else {
                        const errorMessage = `S3 upload failed (${code}): ${errorOutput || output}`
                        console.error(errorMessage)
                        reject(new Error(errorMessage))
                    }
                })
            })
        } catch (error: any) {
            console.error('S3 upload error:', error.message)
            throw error
        }
    }

    public async uploadToDefaultBucket(
        filePath: string,
        s3Path: string,
        s3_args: string[],
    ): Promise<string> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return Promise.resolve('')
        }

        try {
            return await this.uploadFile(
                filePath,
                GLOBAL.get().remote.aws_s3_log_bucket,
                s3Path,
                s3_args,
            )
        } catch (error: any) {
            console.error('Failed to upload to default bucket:', error.message)
            throw error
        }
    }

    public async uploadDirectory(
        localDir: string,
        bucketName: string,
        s3Path: string,
        s3Args?: string[],
    ): Promise<string> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return Promise.resolve('')
        }

        try {
            const s3FullPath = `s3://${bucketName}/${s3Path}`

            s3Args = this.getS3Args(s3Args)

            // Create the full command array
            const fullArgs = [
                ...s3Args,
                's3',
                'sync',
                localDir,
                s3FullPath,
                '--acl',
                'public-read',
                '--delete', // Remove files in S3 that don't exist locally
            ]

            console.log('🔍 S3 sync command:', 'aws', fullArgs.join(' '))

            return new Promise((resolve, reject) => {
                const awsProcess = spawn('aws', fullArgs)
                let output = ''
                let errorOutput = ''

                awsProcess.stdout.on('data', (data) => {
                    output += data.toString()
                })

                awsProcess.stderr.on('data', (data) => {
                    errorOutput += data.toString()
                    console.error('S3 sync error:', data.toString().trim())
                })

                awsProcess.on('error', (error) => {
                    console.error(
                        'Failed to start AWS CLI process:',
                        error.message,
                    )
                    reject(
                        new Error(
                            `AWS CLI process failed to start: ${error.message}`,
                        ),
                    )
                })

                awsProcess.on('close', (code) => {
                    if (code === 0) {
                        const publicUrl = `https://${bucketName}.${S3_ENDPOINT}/${s3Path}`
                        resolve(publicUrl)
                    } else {
                        const errorMessage = `S3 sync failed (${code}): ${errorOutput || output}`
                        console.error(errorMessage)
                        reject(new Error(errorMessage))
                    }
                })
            })
        } catch (error: any) {
            console.error('S3 sync error:', error.message)
            throw error
        }
    }
}

// Export utility functions that use the singleton instance
export const s3cp = (
    local: string,
    s3path: string,
    s3_args: string[],
): Promise<string> =>
    S3Uploader.getInstance().uploadToDefaultBucket(local, s3path, s3_args)
