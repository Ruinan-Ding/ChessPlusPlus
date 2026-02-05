# Generated manually to add 'invited' status to PlayerConnection

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('game', '0002_gameroom_host_token_gameroom_opponent_token_and_more'),
    ]

    operations = [
        migrations.AlterField(
            model_name='playerconnection',
            name='status',
            field=models.CharField(
                choices=[
                    ('online', 'In lobby'),
                    ('invited', 'Has pending invite'),
                    ('configuring', 'In setup screen'),
                    ('in-game', 'In game room'),
                ],
                default='online',
                max_length=15
            ),
        ),
    ]
