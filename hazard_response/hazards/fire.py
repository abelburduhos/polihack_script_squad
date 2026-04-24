from .base import AlertRule, Comparator, HazardType, register_hazard


WILDFIRE = HazardType(
    name="wildfire",
    rules=[
        AlertRule("smoke", threshold=400.0, comparator=Comparator.GT, severity_weight=2.0),
        AlertRule("temperature", threshold=45.0, comparator=Comparator.GT, severity_weight=1.5),
        AlertRule("humidity", threshold=20.0, comparator=Comparator.LT, severity_weight=1.0),
    ],
    vision_prompt=(
        "You are reviewing an aerial drone image for wildfire signs. "
        "Report: visible flames, smoke column direction and density, affected area size, "
        "proximity to structures or roads, wind indicators. Rate threat 0-10 and recommend "
        "immediate actions."
    ),
    # Two signals reduce false positives (e.g. a hot day alone isn't a fire).
    min_rules_to_trigger=2,
)

register_hazard(WILDFIRE)
