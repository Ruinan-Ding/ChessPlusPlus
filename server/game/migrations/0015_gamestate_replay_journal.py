from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('game', '0014_ability_state')]
    operations = [migrations.AddField(
        model_name='gamestate', name='replay_journal',
        field=models.JSONField(blank=True, null=True),
    )]
