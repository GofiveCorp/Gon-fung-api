#!/bin/bash
# Script to run the serverless bot with predefined parameters
# Just modify the JSON below to change the meeting parameters

# Generate a random UUID for the bot
BOT_UUID=$(uuidgen)

# Meeting parameters - modify these as needed
STDIN='{
    "id": "meeting-bot-session",
    "use_my_vocabulary": false,
    "meeting_url": "https://teams.microsoft.com/meet/485437039779?p=YTxOYBbgqFPPLi4Wrz",
    "user_token": "dummy-token-for-production",
    "bot_name": "Recording Bot",
    "user_id": 123,
    "session_id": "production-session",
    "email": "bot@example.com",
    "vocabulary": [],
    "force_lang": false,
    "speech_to_text_provider": "Default",
    "speech_to_text_api_key": "",
    "streaming_input": "",
    "streaming_output": "",
    "streaming_audio_frequency": 24000,
    "bots_api_key": "your-api-key-here",
    "bots_webhook_url": "",
    "bot_uuid": "unique-bot-identifier",
    "enter_message": "Recording bot has joined the meeting",
    "recording_mode": "speaker_view",
    "local_recording_server_location": "docker",
    "automatic_leave": {
        "waiting_room_timeout": 600,
        "noone_joined_timeout": 600
    },
    "mp4_s3_path": "recordings/output.mp4",
    "custom_branding_bot_path": "https://i.ibb.co/N9YtnDZ/ducobu.jpg",
    "environ": "local",
    "aws_s3_temporary_audio_bucket": "local-audio-bucket",
    "remote": null,
    "secret": "your-secret-key"
}'

# Extract some parameters for display
MEETING_URL=$(echo "$STDIN" | sed -n 's/.*"meeting_url": *"\([^"]*\)".*/\1/p')
BOT_NAME=$(echo "$STDIN" | sed -n 's/.*"bot_name": *"\([^"]*\)".*/\1/p')
BOT_UUID=$(echo "$STDIN" | sed -n 's/.*"bot_uuid": *"\([^"]*\)".*/\1/p')

export STDIN
export SERVERLESS=true

echo "Starting serverless bot with parameters:"
echo "- Meeting URL: $MEETING_URL"
echo "- Bot Name: $BOT_NAME"
echo "- Bot UUID: $BOT_UUID"
echo ""

# Build the server
npm run build

# Run the serverless bot
echo "$STDIN" | SERVERLESS=true npm run start