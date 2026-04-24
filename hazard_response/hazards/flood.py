from .base import AlertRule, Comparator, HazardType, register_hazard


FLASH_FLOOD = HazardType(
    name="flash_flood",
    rules=[
        AlertRule("water_level", threshold=3.0, comparator=Comparator.GT, severity_weight=2.0),
        AlertRule("rainfall", threshold=25.0, comparator=Comparator.GT, severity_weight=1.5),
        AlertRule("flow_rate", threshold=80.0, comparator=Comparator.GT, severity_weight=1.0),
    ],
    vision_prompt=(
        "You are reviewing an aerial drone image for flash-flood signs. "
        "Report: water extent vs. normal channel, debris flow, submerged roads or buildings, "
        "people or vehicles in danger. Rate threat 0-10 and recommend immediate actions."
    ),
    min_rules_to_trigger=1,
)

register_hazard(FLASH_FLOOD)
