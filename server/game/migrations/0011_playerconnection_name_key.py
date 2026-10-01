from django.db import migrations, models


def fill_name_keys(apps, schema_editor):
    """Key every row, and of two that now count as one name keep the freshest:
    it is the one somebody is using. The rest are presence rows, which their
    players recreate on the next join."""
    PlayerConnection = apps.get_model('game', 'PlayerConnection')
    seen = set()
    for row in PlayerConnection.objects.order_by('-last_activity'):
        key = row.username.casefold()
        if key in seen:
            row.delete()
            continue
        seen.add(key)
        PlayerConnection.objects.filter(pk=row.pk).update(name_key=key)


class Migration(migrations.Migration):

    dependencies = [
        ('game', '0010_gamedisconnect'),
    ]

    operations = [
        migrations.AddField(
            model_name='playerconnection',
            name='name_key',
            field=models.CharField(editable=False, max_length=96, null=True),
        ),
        migrations.RunPython(fill_name_keys, migrations.RunPython.noop),
        migrations.AlterField(
            model_name='playerconnection',
            name='name_key',
            field=models.CharField(editable=False, max_length=96, unique=True),
        ),
    ]
